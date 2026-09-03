import { describe, it, expect } from 'vitest';
import {
  normalizeIngredientIdentity,
  normalizeIngredientText,
  buildRecipeRelationshipIndex,
  getRecipesUsingIngredient,
  getIngredientFrequency,
  getRecipeIngredientProfile,
  getSharedIngredients,
  scoreRecipeSimilarity,
  findSimilarRecipes,
  recipeIdentity,
  type RecipeLike,
} from '../../src/utils/recipeRelationships';

const ing = (original: string) => ({ original });

describe('recipeRelationships: normalization', () => {
  it('removes the amount', () => {
    expect(normalizeIngredientText('2 eggs')).toBe('eggs');
    expect(normalizeIngredientIdentity({ name: 'eggs', amount: 2 })).toBe('eggs');
    expect(normalizeIngredientText('3 large eggs')).toBe('large eggs');
  });

  it('removes the unit', () => {
    expect(normalizeIngredientText('1 cup All-Purpose Flour')).toBe('all-purpose flour');
    expect(normalizeIngredientText('240 ml heavy cream')).toBe('heavy cream');
    expect(normalizeIngredientText('2 tbsp butter')).toBe('butter');
  });

  it('normalizes case and whitespace', () => {
    expect(normalizeIngredientText('Eggs')).toBe('eggs');
    expect(normalizeIngredientText('  Eggs  ')).toBe('eggs');
    expect(normalizeIngredientText('CHICKEN BREAST')).toBe('chicken breast');
  });

  it('reparses the safe canonical parser even when the legacy name is corrupted', () => {
    // The legacy tokenizer yields a corrupted name; `original` is used instead.
    expect(normalizeIngredientIdentity({ original: '3 large eggs', name: 'arge eggs', unit: 'l' })).toBe('large eggs');
    expect(normalizeIngredientIdentity({ original: '1 garlic clove', name: 'arlic clove', unit: 'g' })).toBe('garlic clove');
  });
});

describe('recipeRelationships: wikilink handling', () => {
  it('reduces wikilinks to their target text', () => {
    expect(normalizeIngredientText('[[Egg]]')).toBe('egg');
    expect(normalizeIngredientText('[[Egg|eggs]]')).toBe('egg');
    expect(normalizeIngredientText('[[Chicken Breast]]')).toBe('chicken breast');
    expect(normalizeIngredientText('[[All-Purpose Flour]]')).toBe('all-purpose flour');
  });

  it('uses the wikilink TARGET for identity (target-authority)', () => {
    // Display alias never overrides identity for distinct explicit targets.
    expect(normalizeIngredientText('[[Chicken Breast|chicken]]')).toBe('chicken breast');
    expect(normalizeIngredientText('[[Chicken Thigh|chicken]]')).toBe('chicken thigh');
    expect(normalizeIngredientText('[[Chicken Breast|chicken]]')).toBe(
      normalizeIngredientText('[[Chicken Breast]]')
    );
    expect(normalizeIngredientText('[[Chicken Breast|chicken]]')).toBe(
      normalizeIngredientText('chicken breast')
    );
    expect(normalizeIngredientText('[[Chicken Breast|chicken]]')).not.toBe(
      normalizeIngredientText('[[Chicken Thigh|chicken]]')
    );
  });

  it('documents the recall tradeoff of target-authority', () => {
    // [[Egg|eggs]] reduces to its target "egg", so it no longer aligns with "2 eggs".
    expect(normalizeIngredientText('[[Egg|eggs]]')).toBe('egg');
    expect(normalizeIngredientText('[[Egg|eggs]]')).not.toBe(normalizeIngredientText('2 eggs'));
    expect(normalizeIngredientText('[[Egg|eggs]]')).toBe(normalizeIngredientText('egg'));
  });

  it('never mutates the original ingredient string', () => {
    const ingredient = { original: '8 oz [[Chicken Breast]]', name: '[[Chicken Breast]]' };
    normalizeIngredientIdentity(ingredient);
    expect(ingredient.original).toBe('8 oz [[Chicken Breast]]');
    expect(ingredient.name).toBe('[[Chicken Breast]]');
  });
});

describe('recipeRelationships: false positives (must remain distinct)', () => {
  it('keeps lookalike ingredients distinct', () => {
    const pairs: [string, string][] = [
      ['egg', 'eggplant'],
      ['butter', 'peanut butter'],
      ['cream', 'cream cheese'],
      ['garlic', 'garlic powder'],
      ['onion', 'onion powder'],
      ['chicken breast', 'chicken thigh'],
      ['all-purpose flour', 'almond flour'],
    ];
    for (const [a, b] of pairs) {
      const ka = normalizeIngredientText(a);
      const kb = normalizeIngredientText(b);
      expect(ka).not.toBe(kb);
      expect(ka.length).toBeGreaterThan(0);
      expect(kb.length).toBeGreaterThan(0);
    }
  });

  it('does not do substring matching on lookups', () => {
    const index = buildRecipeRelationshipIndex([
      { id: 'a', ingredients: [ing('2 eggs')] },
      { id: 'b', ingredients: [ing('1 eggplant')] },
    ]);
    // Querying "egg" returns no recipe (no exact singular "egg" key); it must
    // never bleed into the "eggs" or "eggplant" keys (no substring matching).
    expect(getRecipesUsingIngredient(index, 'egg')).toEqual([]);
    expect(getRecipesUsingIngredient(index, 'eggs')).toEqual(['a']);
    expect(getRecipesUsingIngredient(index, 'eggplant')).toEqual(['b']);
  });
});

describe('recipeRelationships: arbitrary ingredients (no nutrition dependence)', () => {
  it('indexes ingredients that are not in the curated nutrition reference', () => {
    const index = buildRecipeRelationshipIndex([
      { id: 'r1', ingredients: [ing('1 tsp paprika'), ing('2 carrots'), ing('soy sauce')] },
    ]);
    expect(index.ingredientIndex.has('paprika')).toBe(true);
    expect(index.ingredientIndex.has('carrots')).toBe(true);
    expect(index.ingredientIndex.has('soy sauce')).toBe(true);
    expect(getRecipesUsingIngredient(index, 'paprika')).toEqual(['r1']);
    expect(getRecipesUsingIngredient(index, 'carrots')).toEqual(['r1']);
    expect(getRecipesUsingIngredient(index, 'soy sauce')).toEqual(['r1']);
    expect(getIngredientFrequency(index, 'paprika')).toEqual({
      key: 'paprika',
      recipeCount: 1,
      occurrenceCount: 1,
    });
  });
});

describe('recipeRelationships: index structure', () => {
  const recipes = buildVaultRecipes();

  it('ingredient -> recipes', () => {
    const idx = buildRecipeRelationshipIndex(recipes);
    expect(getRecipesUsingIngredient(idx, 'garlic')).toEqual([
      'chicken-alfredo',
      'creamy-garlic-chicken',
      'garlic-bread',
    ]);
    expect(getRecipesUsingIngredient(idx, 'chicken breast')).toEqual([
      'chicken-alfredo',
      'creamy-garlic-chicken',
    ]);
  });

  it('recipe -> ingredient profile', () => {
    const idx = buildRecipeRelationshipIndex(recipes);
    const profile = getRecipeIngredientProfile(idx, 'chicken-alfredo');
    expect(profile?.ingredientKeys.sort()).toEqual([
      'chicken breast',
      'garlic',
      'heavy cream',
      'parmesan cheese',
    ].sort());
    expect(profile?.uniqueCount).toBe(4);
  });

  it('frequency exposes both recipeCount and occurrenceCount', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'r1', ingredients: [ing('2 tbsp butter'), ing('1 tbsp butter'), ing('2 eggs')] },
      { id: 'r2', ingredients: [ing('1 tbsp butter')] },
    ]);
    expect(getIngredientFrequency(idx, 'butter')).toEqual({
      key: 'butter',
      recipeCount: 2,
      occurrenceCount: 3,
    });
  });
});

describe('recipeRelationships: duplicates within a recipe', () => {
  it('dup ingredients do not inflate a recipe unique set but still count occurrences', () => {
    const index = buildRecipeRelationshipIndex([
      { id: 'r1', ingredients: [ing('2 tbsp butter'), ing('1 tbsp butter'), ing('2 eggs')] },
    ]);
    const profile = getRecipeIngredientProfile(index, 'r1');
    expect(profile?.ingredientKeys.sort()).toEqual(['butter', 'eggs']);
    expect(profile?.uniqueCount).toBe(2);
    expect(profile?.occurrenceCount).toBe(3);
  });

  it('repeated ingredients do not inflate recipe similarity (unique sets)', () => {
    const index = buildRecipeRelationshipIndex([
      { id: 'a', ingredients: [ing('2 tbsp butter'), ing('1 tbsp butter'), ing('2 eggs')] },
      { id: 'b', ingredients: [ing('1 tbsp butter'), ing('3 eggs')] },
    ]);
    const sim = scoreRecipeSimilarity(index, 'a', 'b');
    // Both unique sets are {butter, eggs}; shared 2, union 2 -> 1, not inflated by butter duplicates.
    expect(sim.sharedCount).toBe(2);
    expect(sim.unionCount).toBe(2);
    expect(sim.score).toBe(1);
  });
});

describe('recipeRelationships: shared ingredients', () => {
  it('computes the correct intersection', () => {
    const idx = buildRecipeRelationshipIndex(buildVaultRecipes());
    expect(getSharedIngredients(idx, 'chicken-alfredo', 'creamy-garlic-chicken')).toEqual([
      'chicken breast',
      'garlic',
      'heavy cream',
    ]);
    expect(getSharedIngredients(idx, 'chicken-alfredo', 'pancakes')).toEqual([]);
  });
});

describe('recipeRelationships: Jaccard similarity', () => {
  it('computes an exact known score', () => {
    const idx = buildRecipeRelationshipIndex(buildVaultRecipes());
    const sim = scoreRecipeSimilarity(idx, 'chicken-alfredo', 'creamy-garlic-chicken');
    expect(sim.sharedCount).toBe(3);
    expect(sim.unionCount).toBe(5);
    expect(sim.score).toBeCloseTo(3 / 5, 10);
    expect(sim.sharedIngredientKeys).toEqual(['chicken breast', 'garlic', 'heavy cream']);
  });

  it('identical sets score 1', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'a', ingredients: [ing('2 eggs'), ing('1 cup flour')] },
      { id: 'b', ingredients: [ing('3 eggs'), ing('2 cups flour')] },
    ]);
    const sim = scoreRecipeSimilarity(idx, 'a', 'b');
    expect(sim.sharedCount).toBe(2);
    expect(sim.unionCount).toBe(2);
    expect(sim.score).toBe(1);
  });

  it('non-overlapping sets score 0', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'a', ingredients: [ing('chicken breast')] },
      { id: 'b', ingredients: [ing('sugar'), ing('flour')] },
    ]);
    expect(scoreRecipeSimilarity(idx, 'a', 'b').score).toBe(0);
  });

  it('handles empty unions safely (no division by zero)', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'a', ingredients: [] },
      { id: 'b', ingredients: [] },
    ]);
    const sim = scoreRecipeSimilarity(idx, 'a', 'b');
    expect(sim.unionCount).toBe(0);
    expect(sim.sharedCount).toBe(0);
    expect(sim.score).toBe(0);
    expect(Number.isFinite(sim.score)).toBe(true);
  });
});

describe('recipeRelationships: similar recipes', () => {
  it('excludes the source recipe, sorts by score desc, and omits zero-overlap', () => {
    const idx = buildRecipeRelationshipIndex(buildVaultRecipes());
    const results = findSimilarRecipes(idx, 'chicken-alfredo');

    // Never includes itself.
    expect(results.some((r) => r.recipeId === 'chicken-alfredo')).toBe(false);

    // Creamy Garlic Chicken (0.6) ranks above Garlic Bread (1/6); Pancakes (0) omitted.
    expect(results[0].recipeId).toBe('creamy-garlic-chicken');
    expect(results[0].score).toBeCloseTo(3 / 5, 10);
    expect(results[1].recipeId).toBe('garlic-bread');
    expect(results[1].score).toBeCloseTo(1 / 6, 10);
    expect(results.some((r) => r.recipeId === 'pancakes')).toBe(false);
  });

  it('sorts deterministically with a stable tie-breaker and supports limit', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'target', ingredients: [ing('garlic'), ing('butter')] },
      { id: 'x', ingredients: [ing('garlic'), ing('bread')] },
      { id: 'y', ingredients: [ing('butter'), ing('cheese')] },
    ]);
    const all = findSimilarRecipes(idx, 'target');
    // x and y both share 1/3; tie broken by recipeId asc -> x before y.
    expect(all.map((r) => r.recipeId)).toEqual(['x', 'y']);
    expect(findSimilarRecipes(idx, 'target', { limit: 1 }).length).toBe(1);
  });
});

describe('recipeRelationships: preparation handling', () => {
  it('shares identity across preparation variants via the comma convention', () => {
    const diced = normalizeIngredientText('1 onion, diced');
    const chopped = normalizeIngredientText('1 onion, chopped');
    const finely = normalizeIngredientText('1 onion, finely diced');
    expect(diced).toBe('onion');
    expect(chopped).toBe('onion');
    expect(finely).toBe('onion');
  });
});

describe('recipeRelationships: qualitative text', () => {
  it('indexes qualitative phrases safely as the base ingredient', () => {
    expect(normalizeIngredientText('salt to taste')).toBe('salt');
    expect(normalizeIngredientText('salt, optional')).toBe('salt');
    expect(normalizeIngredientText('salt (optional)')).toBe('salt');
    expect(normalizeIngredientText('pepper as needed')).toBe('pepper');
  });
});

describe('recipeRelationships: immutability & no wikilink generation', () => {
  it('never mutates input recipes or ingredients', () => {
    const recipes = buildVaultRecipes();
    const snapshot = JSON.parse(JSON.stringify(recipes));
    buildRecipeRelationshipIndex(recipes);
    expect(JSON.stringify(recipes)).toBe(JSON.stringify(snapshot));
  });

  it('produces keys with no wikilink brackets and never writes wikilinks', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'r1', ingredients: [{ original: '[[Egg|eggs]]', wikilink: 'Egg|eggs', wikilinkTarget: 'Egg', wikilinkAlias: 'eggs', name: '[[Egg|eggs]]' }] },
    ]);
    for (const key of idx.ingredientIndex.keys()) {
      expect(key.includes('[')).toBe(false);
      expect(key.includes(']')).toBe(false);
      expect(key.includes('|')).toBe(false);
    }
    // The module is a pure read transform; it emits no wikilinks anywhere.
    expect(idx.ingredientIndex.get('egg')?.displayName).toBe('eggs');
  });

  it('returns defensive copies from profile queries', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'r1', ingredients: [ing('2 eggs')] },
    ]);
    const profile = getRecipeIngredientProfile(idx, 'r1')!;
    profile.ingredientKeys.push('evil');
    const again = getRecipeIngredientProfile(idx, 'r1')!;
    expect(again.ingredientKeys).toEqual(['eggs']);
  });
});

describe('recipeRelationships: recipe identity', () => {
  it('prefers id, then filePath, then fileName, never title alone', () => {
    expect(recipeIdentity({ id: 'abc', title: 'X' } as RecipeLike)).toBe('abc');
    expect(recipeIdentity({ filePath: 'A.md', title: 'X' } as RecipeLike)).toBe('A.md');
    expect(recipeIdentity({ fileName: 'B.md', title: 'X' } as RecipeLike)).toBe('B.md');
  });
});

describe('recipeRelationships: preparation comma rule (safety > recall)', () => {
  it('collapses true preparation via the closed cue list', () => {
    expect(normalizeIngredientText('1 onion, diced')).toBe('onion');
    expect(normalizeIngredientText('1 onion, chopped')).toBe('onion');
    expect(normalizeIngredientText('1 onion, finely diced')).toBe('onion');
    expect(normalizeIngredientText('2 carrots, sliced')).toBe('carrots');
    expect(normalizeIngredientText('1 chicken breast, cooked and chopped')).toBe('chicken breast');
  });

  it('preserves variety/type descriptors (no false collapse)', () => {
    const distinct: [string, string][] = [
      ['beans, black', 'beans, kidney'],
      ['rice, brown', 'rice, wild'],
      ['cheese, cream', 'cheese, blue'],
      ['tomatoes, canned', 'tomatoes, sun-dried'],
      ['oil, olive', 'oil, sesame'],
      ['peppers, roasted red', 'peppers, green'],
      ['mustard, Dijon', 'mustard, yellow'],
      ['chocolate, dark', 'chocolate, milk'],
      ['vinegar, apple cider', 'vinegar, balsamic'],
    ];
    for (const [a, b] of distinct) {
      expect(normalizeIngredientText(a)).not.toBe(normalizeIngredientText(b));
      // And they must not collapse to the bare base either.
      expect(normalizeIngredientText(a).length).toBeGreaterThan(1);
    }
    // Explicit regression: the old bug collapsed both of these to "beans".
    expect(normalizeIngredientText('beans, black')).toBe('beans, black');
    expect(normalizeIngredientText('beans, kidney')).toBe('beans, kidney');
  });
});

describe('recipeRelationships: mini-vault adversarial (blocking fixes)', () => {
  it('comma-form bean/rice varieties stay distinct (sharedCount = 0)', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'A', ingredients: [ing('beans, black'), ing('rice, brown'), ing('chicken breast')] },
      { id: 'B', ingredients: [ing('beans, kidney'), ing('rice, wild'), ing('chicken thigh')] },
    ]);
    const sim = scoreRecipeSimilarity(idx, 'A', 'B');
    expect(sim.sharedCount).toBe(0);
    expect(sim.score).toBe(0);
  });

  it('wikilink target-authority prevents chicken breast/thigh collapse (sharedCount = 0)', () => {
    const idx = buildRecipeRelationshipIndex([
      { id: 'C', ingredients: [{ original: '[[Chicken Breast|chicken]]' }] },
      { id: 'D', ingredients: [{ original: '[[Chicken Thigh|chicken]]' }] },
    ]);
    const sim = scoreRecipeSimilarity(idx, 'C', 'D');
    expect(sim.sharedCount).toBe(0);
    expect(sim.score).toBe(0);
  });
});

// Mirrors the Step 6 mini-vault.
function buildVaultRecipes(): RecipeLike[] {
  return [
    {
      id: 'chicken-alfredo',
      title: 'Chicken Alfredo',
      ingredients: [ing('2 chicken breast'), ing('1 cup heavy cream'), ing('1/2 cup parmesan cheese'), ing('2 cloves garlic')],
    },
    {
      id: 'creamy-garlic-chicken',
      title: 'Creamy Garlic Chicken',
      ingredients: [ing('1 chicken breast'), ing('1/2 cup heavy cream'), ing('2 cloves garlic'), ing('1 onion, diced')],
    },
    {
      id: 'pancakes',
      title: 'Pancakes',
      ingredients: [ing('1 cup flour'), ing('2 eggs'), ing('1 cup milk'), ing('1 tbsp sugar')],
    },
    {
      id: 'garlic-bread',
      title: 'Garlic Bread',
      ingredients: [ing('1 loaf bread'), ing('2 tbsp butter'), ing('3 cloves garlic')],
    },
  ];
}
