import { describe, it, expect } from 'vitest';
import {
  buildRecipeRelationshipIndex,
  findSimilarRecipes,
  classifyDishFamily,
  areRelatedFamilies,
  DEFAULT_SIMILARITY_LIMIT,
  MAX_SIMILARITY_LIMIT,
  type RecipeLike,
} from '../../src/utils/recipeRelationships';
import { searchKitchenRecipes } from '../../src/utils/kitchenSearch';

const ing = (original: string) => ({ original });

function recipe(
  id: string,
  title: string,
  opts: { ings: string[]; cuisine?: string; category?: string; tags?: string[] } = { ings: [] }
): RecipeLike {
  return {
    id,
    title,
    cuisine: opts.cuisine,
    category: opts.category,
    tags: opts.tags ?? [],
    ingredients: opts.ings.map(ing),
  };
}

describe('culinarySimilarity: dish-family classification', () => {
  const classify = (title: string, category?: string, tags: string[] = []) =>
    classifyDishFamily({ title, category, tags });

  it('classifies common dish families from trusted metadata', () => {
    expect(classify('Chicken Caesar Salad')).toBe('salad');
    expect(classify('Beef Tacos')).toBe('taco');
    expect(classify('Chicken Soup')).toBe('soup');
    expect(classify('Beef Stew')).toBe('stew');
    expect(classify('Chocolate Cake')).toBe('cake');
    expect(classify('Chicken Alfredo')).toBe('pasta');
    expect(classify('Garlic Bread')).toBe('bread');
    expect(classify('Margarita')).toBe('drink');
    expect(classify('Cheese Enchiladas')).toBe('enchilada');
    expect(classify('Bean Burrito')).toBe('burrito');
  });

  it('returns undefined for an unrecognized recipe (no invented family)', () => {
    expect(classify('My Kitchen Creation')).toBeUndefined();
    expect(classify('', 'Main Course')).toBeUndefined();
  });

  it('never lets a shared protein beat the dish type (Chicken Soup -> soup, not chicken)', () => {
    expect(classify('Chicken Soup')).toBe('soup');
  });

  it('uses the course fallback only for a clear distinct course', () => {
    expect(classifyDishFamily({ title: '', category: 'Dessert', tags: [] })).toBe('dessert');
  });
});

describe('culinarySimilarity: related dish groups', () => {
  it('treats Mexican/Tex-Mex families as related', () => {
    expect(areRelatedFamilies('taco', 'burrito')).toBe(true);
    expect(areRelatedFamilies('taco', 'enchilada')).toBe(true);
    expect(areRelatedFamilies('quesadilla', 'fajita')).toBe(true);
  });

  it('does not treat unrelated families as related', () => {
    expect(areRelatedFamilies('salad', 'pasta')).toBe(false);
    expect(areRelatedFamilies('taco', 'soup')).toBe(false);
    expect(areRelatedFamilies('dessert', 'beef')).toBe(false);
  });
});

describe('culinarySimilarity: salad case (culinary type beats incidental overlap)', () => {
  const vault = [
    recipe('caesar', 'Chicken Caesar Salad', { ings: ['romaine', 'chicken breast', 'parmesan', 'garlic', 'croutons'], cuisine: 'American', category: 'Main Course' }),
    recipe('greek', 'Greek Salad', { ings: ['romaine', 'feta', 'cucumber', 'tomato', 'olive'], cuisine: 'Greek', category: 'Main Course' }),
    recipe('cobb', 'Cobb Salad', { ings: ['romaine', 'chicken breast', 'bacon', 'egg', 'tomato'], cuisine: 'American', category: 'Main Course' }),
    recipe('alfredo', 'Chicken Alfredo', { ings: ['chicken breast', 'heavy cream', 'parmesan', 'garlic'], cuisine: 'Italian', category: 'Main Course' }),
    recipe('garlic-bread', 'Garlic Bread', { ings: ['bread', 'butter', 'garlic'], cuisine: 'Italian', category: 'Main Course' }),
    recipe('lemonade', 'Lemonade', { ings: ['lemon', 'sugar', 'water'], cuisine: 'American', category: 'Beverage' }),
  ];
  const idx = buildRecipeRelationshipIndex(vault);

  it('ranks the actual salads above unrelated dishes regardless of ingredient overlap', () => {
    const results = findSimilarRecipes(idx, 'caesar');
    const ids = results.map((r) => r.recipeId);

    // Both salads appear, first two.
    expect(ids).toEqual(['cobb', 'greek']);
    expect(ids).not.toContain('alfredo');
    expect(ids).not.toContain('garlic-bread');
    expect(ids).not.toContain('lemonade');

    // Chicken Alfredo shares chicken + parmesan with the Caesar salad, but is a
    // genuinely different culinary type and must never outrank the salads.
    expect(results.every((r) => r.reason.includes('Same type · Salad'))).toBe(true);
  });
});

describe('culinarySimilarity: taco case (related Mexican family beats beef overlap)', () => {
  const vault = [
    recipe('beef-tacos', 'Beef Tacos', { ings: ['beef', 'tortilla', 'cheddar', 'lettuce', 'tomato'], cuisine: 'Mexican', category: 'Main Course' }),
    recipe('chicken-tacos', 'Chicken Tacos', { ings: ['chicken', 'tortilla', 'cheddar', 'lettuce'], cuisine: 'Mexican', category: 'Main Course' }),
    recipe('burrito', 'Bean Burrito', { ings: ['beans', 'tortilla', 'rice', 'cheese'], cuisine: 'Mexican', category: 'Main Course' }),
    recipe('enchilada', 'Cheese Enchiladas', { ings: ['tortilla', 'cheese', 'salsa', 'onion'], cuisine: 'Mexican', category: 'Main Course' }),
    recipe('beef-stew', 'Beef Stew', { ings: ['beef', 'potato', 'carrot', 'onion'], cuisine: 'American', category: 'Main Course' }),
    recipe('chili', 'Hot Dog Chili', { ings: ['beef', 'tomato', 'onion', 'beans'], cuisine: 'American', category: 'Main Course' }),
    recipe('stromboli', 'Stromboli', { ings: ['bread', 'pepperoni', 'cheese', 'sauce'], cuisine: 'Italian', category: 'Main Course' }),
  ];
  const idx = buildRecipeRelationshipIndex(vault);

  it('puts the same-type taco first and related Mexican dishes next; excludes the beef stew', () => {
    const results = findSimilarRecipes(idx, 'beef-tacos');
    const ids = results.map((r) => r.recipeId);

    expect(ids[0]).toBe('chicken-tacos');
    expect(ids).toContain('burrito');
    expect(ids).toContain('enchilada');

    // Beef Stew, Chili and Stromboli are unrelated culinary types and are gated
    // out even though Beef Stew shares "beef" with the source.
    expect(ids).not.toContain('beef-stew');
    expect(ids).not.toContain('chili');
    expect(ids).not.toContain('stromboli');

    // Same-type taco edges out the related Mexican dishes.
    const chicken = results.find((r) => r.recipeId === 'chicken-tacos')!;
    const burritic = results.find((r) => r.recipeId === 'burrito')!;
    expect(chicken.score).toBeGreaterThan(burritic.score);
    expect(burritic.reason).toContain('Mexican');
  });
});

describe('culinarySimilarity: soup case (soup/stew beats unrelated chicken entree)', () => {
  const vault = [
    recipe('chicken-soup', 'Chicken Soup', { ings: ['chicken', 'stock', 'carrot', 'celery', 'onion'], cuisine: 'American', category: 'Main Course' }),
    recipe('chicken-stew', 'Chicken Stew', { ings: ['chicken', 'potato', 'carrot', 'onion'], cuisine: 'American', category: 'Main Course' }),
    recipe('chicken-alfredo', 'Chicken Alfredo', { ings: ['chicken', 'cream', 'parmesan'], cuisine: 'Italian', category: 'Main Course' }),
  ];
  const idx = buildRecipeRelationshipIndex(vault);

  it('recommends the related stew, not the unrelated chicken pasta sharing "chicken"', () => {
    const ids = findSimilarRecipes(idx, 'chicken-soup').map((r) => r.recipeId);
    expect(ids).toEqual(['chicken-stew']);
    const stew = findSimilarRecipes(idx, 'chicken-soup').find((r) => r.recipeId === 'chicken-stew')!;
    expect(stew.reason).toContain('Related');
  });
});

describe('culinarySimilarity: dessert case (no savory entrees from flour/butter overlap)', () => {
  const vault = [
    recipe('choc-cake', 'Chocolate Cake', { ings: ['flour', 'sugar', 'butter', 'egg', 'cocoa'], cuisine: 'American', category: 'Dessert' }),
    recipe('pound-cake', 'Pound Cake', { ings: ['flour', 'sugar', 'butter', 'egg'], cuisine: 'American', category: 'Dessert' }),
    recipe('cookie', 'Chocolate Chip Cookies', { ings: ['flour', 'sugar', 'butter', 'egg', 'chocolate'], cuisine: 'American', category: 'Dessert' }),
    recipe('roast-chicken', 'Roast Chicken', { ings: ['chicken', 'butter', 'flour', 'salt'], cuisine: 'American', category: 'Main Course' }),
  ];
  const idx = buildRecipeRelationshipIndex(vault);

  it('recommends sweet family members, never the savory entree that overlaps flour/butter', () => {
    const ids = findSimilarRecipes(idx, 'choc-cake').map((r) => r.recipeId);
    expect(ids).toContain('pound-cake');
    expect(ids).toContain('cookie');
    expect(ids).not.toContain('roast-chicken');
    const cake = findSimilarRecipes(idx, 'choc-cake').find((r) => r.recipeId === 'pound-cake')!;
    expect(cake.reason).toContain('Same type · Cake');
  });
});

describe('culinarySimilarity: drink case (no sauces/entrees from lime/sugar overlap)', () => {
  const vault = [
    recipe('margarita', 'Margarita', { ings: ['lime', 'tequila', 'sugar', 'salt'], cuisine: 'Mexican', category: 'Beverage' }),
    recipe('smoothie', 'Berry Smoothie', { ings: ['berry', 'yogurt', 'sugar'], cuisine: 'American', category: 'Beverage' }),
    recipe('salsa', 'Tomato Salsa', { ings: ['tomato', 'onion', 'lime', 'cilantro'], cuisine: 'Mexican', category: 'Condiment' }),
  ];
  const idx = buildRecipeRelationshipIndex(vault);

  it('recommends a fellow drink, never the salsa that shares lime/sugar', () => {
    const ids = findSimilarRecipes(idx, 'margarita').map((r) => r.recipeId);
    expect(ids).toContain('smoothie');
    expect(ids).not.toContain('salsa');
  });
});

describe('culinarySimilarity: weak-match filtering (generic ingredients do not create similarity)', () => {
  const vault = [
    recipe('dish-a', 'Garden Creation', { ings: ['garlic', 'onion', 'salt', 'pepper', 'mushroom'], cuisine: 'American', category: 'Main Course' }),
    recipe('savory-plate', 'Savory Plate', { ings: ['garlic', 'onion', 'salt', 'pepper'], cuisine: 'French', category: 'Main Course' }),
    recipe('asian-noodles', 'Asian Noodles', { ings: ['garlic', 'onion', 'salt', 'pepper', 'noodle'], cuisine: 'Chinese', category: 'Main Course' }),
    recipe('garden-bowl', 'Garden Bowl', { ings: ['garlic', 'onion', 'salt', 'pepper', 'broccoli'], cuisine: 'American', category: 'Main Course' }),
  ];
  const idx = buildRecipeRelationshipIndex(vault);
  const results = findSimilarRecipes(idx, 'dish-a');

  it('excludes unrelated recipes that share only generic pantry ingredients', () => {
    const ids = results.map((r) => r.recipeId);
    expect(ids).not.toContain('savory-plate'); // French: different cuisine
    expect(ids).not.toContain('asian-noodles'); // Chinese: different cuisine
  });

  it('never attributes a recommendation to generic-ingredient overlap alone', () => {
    // Garden Bowl (same American/Main) passes on cuisine/course, but the reason
    // must be CUISINE-based, never "shared ingredient".
    const bowl = results.find((r) => r.recipeId === 'garden-bowl');
    expect(bowl).toBeDefined();
    expect(bowl!.reason).toContain('Same cuisine');
    expect(bowl!.reason).not.toContain('shared ingredient');
    expect(bowl!.sharedNonGenericCount).toBe(0);
  });
});

describe('culinarySimilarity: result cap, stability, no-self', () => {
  const vault: RecipeLike[] = [];
  for (let i = 0; i < 12; i += 1) {
    vault.push(
      recipe(`taco-${i}`, `Tacos ${i}`, { ings: ['tortilla', 'cheese', 'lettuce'], cuisine: 'Mexican', category: 'Main Course' })
    );
  }
  vault.push(recipe('source', 'Loaded Tacos', { ings: ['beef', 'tortilla', 'lettuce'], cuisine: 'Mexican', category: 'Main Course' }));
  const idx = buildRecipeRelationshipIndex(vault);

  it('enforces the default and maximum result caps', () => {
    expect(DEFAULT_SIMILARITY_LIMIT).toBe(6);
    expect(MAX_SIMILARITY_LIMIT).toBe(8);
    const results = findSimilarRecipes(idx, 'source');
    expect(results.length).toBeLessThanOrEqual(DEFAULT_SIMILARITY_LIMIT);
    const many = findSimilarRecipes(idx, 'source', { limit: 20 });
    expect(many.length).toBeLessThanOrEqual(MAX_SIMILARITY_LIMIT);
  });

  it('never recommends the source itself and is stable across calls', () => {
    const first = findSimilarRecipes(idx, 'source');
    const second = findSimilarRecipes(idx, 'source');
    expect(first.some((r) => r.recipeId === 'source')).toBe(false);
    expect(first.map((r) => r.recipeId)).toEqual(second.map((r) => r.recipeId));
  });
});

describe('culinarySimilarity: classifier edge cases (pinned behavior)', () => {
  const classify = (title: string, category?: string, tags: string[] = []) =>
    classifyDishFamily({ title, category, tags });

  it('D: Taco Soup keeps classifying as soup', () => {
    expect(classify('Taco Soup')).toBe('soup');
  });

  it('pins the current classifier behavior for the other known edge cases (future refinement)', () => {
    expect(classify('Pizza Sauce')).toBe('pizza');
    expect(classify('Caesar Dressing')).toBe('salad');
    expect(classify('Dessert Pizza')).toBe('pizza');
    expect(classify('Chicken Pot Pie')).toBe('pie');
  });
});

describe('culinarySimilarity: family-mismatch gate (v0.4.1 hardening)', () => {
  it('A: same cuisine + same course does NOT qualify a known unrelated family (Chicken Soup vs Chicken Sandwich)', () => {
    const vault = [
      recipe('chicken-soup', 'Chicken Soup', { ings: ['chicken', 'stock', 'carrot', 'celery'], cuisine: 'American', category: 'Main Course' }),
      recipe('chicken-sandwich', 'Chicken Sandwich', { ings: ['chicken', 'bread', 'mayo', 'lettuce'], cuisine: 'American', category: 'Main Course' }),
      recipe('beef-stew', 'Beef Stew', { ings: ['beef', 'potato', 'carrot', 'onion'], cuisine: 'American', category: 'Main Course' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const ids = findSimilarRecipes(idx, 'chicken-soup').map((r) => r.recipeId);
    expect(ids).toContain('beef-stew'); // soup ~ stew related, same cuisine + course
    expect(ids).not.toContain('chicken-sandwich'); // sandwich is an unrelated known family
  });

  it('B: same cuisine + same course does NOT qualify a salad against a pasta (Chicken Caesar Salad vs Chicken Alfredo)', () => {
    const vault = [
      recipe('caesar', 'Chicken Caesar Salad', { ings: ['romaine', 'chicken breast', 'parmesan', 'garlic', 'croutons'], cuisine: 'American', category: 'Main Course' }),
      recipe('alfredo', 'Chicken Alfredo', { ings: ['chicken breast', 'heavy cream', 'parmesan', 'garlic'], cuisine: 'American', category: 'Main Course' }),
      recipe('greek', 'Greek Salad', { ings: ['romaine', 'feta', 'cucumber', 'tomato', 'olive'], cuisine: 'American', category: 'Main Course' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const ids = findSimilarRecipes(idx, 'caesar').map((r) => r.recipeId);
    expect(ids).toContain('greek'); // same salad family
    expect(ids).not.toContain('alfredo'); // pasta, unrelated, despite same cuisine + course
  });

  it('C: shared chicken + parmesan does NOT qualify a known unrelated family (salad vs pasta)', () => {
    const vault = [
      recipe('caesar', 'Chicken Caesar Salad', { ings: ['chicken breast', 'parmesan', 'romaine', 'garlic'], cuisine: 'American', category: 'Main Course' }),
      recipe('alfredo', 'Chicken Alfredo', { ings: ['chicken breast', 'parmesan', 'heavy cream', 'garlic'], cuisine: 'American', category: 'Main Course' }),
      recipe('cobb', 'Cobb Salad', { ings: ['romaine', 'chicken breast', 'bacon', 'egg', 'tomato'], cuisine: 'American', category: 'Main Course' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const ids = findSimilarRecipes(idx, 'caesar').map((r) => r.recipeId);
    // chicken breast + parmesan are BOTH shared non-generic ingredients, but the
    // known-and-unrelated family (pasta) must still be excluded.
    expect(ids).not.toContain('alfredo');
    expect(ids).toContain('cobb'); // a real salad still qualifies
  });
});

describe('culinarySimilarity: generic pantry noise & generic-tag-only mismatches (v0.4.1 hardening)', () => {
  it('E: a pair sharing only pantry noise (garlic powder, onion powder, olive oil, kosher salt, black pepper) is NOT a meaningful ingredient match', () => {
    const vault = [
      recipe('blend-a', 'Pantry Blend A', { ings: ['garlic powder', 'onion powder', 'olive oil', 'kosher salt', 'black pepper'] }),
      recipe('blend-b', 'Pantry Blend B', { ings: ['garlic powder', 'onion powder', 'olive oil', 'kosher salt', 'black pepper', 'paprika'] }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const results = findSimilarRecipes(idx, 'blend-a');
    // blend-b shares only generic pantry noise (all 5 are similarity-generic),
    // so it must NOT qualify as a meaningful match and must never be returned.
    expect(results.map((r) => r.recipeId)).not.toContain('blend-b');
  });

  it('F: two weak generic tags (easy, quick, dinner) do NOT qualify an unrelated pair', () => {
    const vault = [
      recipe('a', 'Easy Weeknight Skillet', { ings: ['chicken', 'rice'], cuisine: 'Italian', tags: ['easy', 'quick', 'dinner'] }),
      recipe('b', 'Quick Family Sheet Pan', { ings: ['beef', 'potato'], cuisine: 'French', tags: ['easy', 'quick', 'dinner'] }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    // b shares only the generic tags easy/quick/dinner with a, with a different
    // cuisine, different family and no shared meaningful ingredients -> no match.
    expect(findSimilarRecipes(idx, 'a').map((r) => r.recipeId)).not.toContain('b');
  });
});

describe('culinarySimilarity: score bounds, result caps, determinism, no-self (v0.4.1)', () => {
  const vault: RecipeLike[] = [];
  for (let i = 0; i < 12; i += 1) {
    vault.push(
      recipe(`salad-${i}`, `Salad ${i}`, { ings: ['lettuce', 'tomato', 'cucumber'], cuisine: 'American', category: 'Main Course' })
    );
  }
  vault.push(recipe('source-salad', 'Source Salad', { ings: ['lettuce', 'tomato', 'cucumber', 'chicken'], cuisine: 'American', category: 'Main Course' }));
  const idx = buildRecipeRelationshipIndex(vault);

  it('G: every returned similarity score is bounded to [0, 1]', () => {
    const results = findSimilarRecipes(idx, 'source-salad', { limit: MAX_SIMILARITY_LIMIT });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it('H: default cap is 6 and hard max is 8', () => {
    expect(findSimilarRecipes(idx, 'source-salad').length).toBe(DEFAULT_SIMILARITY_LIMIT);
    expect(findSimilarRecipes(idx, 'source-salad').length).toBeLessThanOrEqual(DEFAULT_SIMILARITY_LIMIT);
    const many = findSimilarRecipes(idx, 'source-salad', { limit: 20 });
    expect(many.length).toBe(MAX_SIMILARITY_LIMIT);
    expect(many.length).toBeLessThanOrEqual(MAX_SIMILARITY_LIMIT);
  });

  it('I: the source recipe is never returned', () => {
    expect(findSimilarRecipes(idx, 'source-salad').some((r) => r.recipeId === 'source-salad')).toBe(false);
  });

  it('J: repeated calls produce the same order (deterministic)', () => {
    const first = findSimilarRecipes(idx, 'source-salad');
    const second = findSimilarRecipes(idx, 'source-salad');
    expect(first.map((r) => r.recipeId)).toEqual(second.map((r) => r.recipeId));
    expect(first.map((r) => r.score)).toEqual(second.map((r) => r.score));
    expect(first.map((r) => r.reason)).toEqual(second.map((r) => r.reason));
  });
});

describe('culinarySimilarity: representative isolation (v0.4.1 rankings)', () => {
  it('SALAD: Chicken Caesar Salad favors salads and excludes unrelated dishes', () => {
    const vault = [
      recipe('caesar', 'Chicken Caesar Salad', { ings: ['romaine', 'chicken breast', 'parmesan', 'croutons'], cuisine: 'American', category: 'Main Course' }),
      recipe('cobb', 'Cobb Salad', { ings: ['romaine', 'chicken breast', 'bacon', 'egg', 'tomato'], cuisine: 'American', category: 'Main Course' }),
      recipe('greek', 'Greek Salad', { ings: ['romaine', 'feta', 'cucumber', 'tomato', 'olive'], cuisine: 'Greek', category: 'Main Course' }),
      recipe('chicken-salad', 'Chicken Salad', { ings: ['chicken', 'celery', 'mayo', 'lettuce'], cuisine: 'American', category: 'Main Course' }),
      recipe('potato-salad', 'Potato Salad', { ings: ['potato', 'mayo', 'celery', 'egg'], cuisine: 'American', category: 'Side' }),
      recipe('alfredo', 'Chicken Alfredo', { ings: ['chicken breast', 'parmesan', 'heavy cream', 'garlic'], cuisine: 'Italian', category: 'Main Course' }),
      recipe('chicken-soup', 'Chicken Soup', { ings: ['chicken', 'stock', 'carrot', 'celery'], cuisine: 'American', category: 'Main Course' }),
      recipe('chicken-tacos', 'Chicken Tacos', { ings: ['chicken', 'tortilla', 'cheese', 'lettuce'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('garlic-bread', 'Garlic Bread', { ings: ['bread', 'butter', 'garlic'], cuisine: 'Italian', category: 'Main Course' }),
      recipe('lemonade', 'Lemonade', { ings: ['lemon', 'sugar', 'water'], cuisine: 'American', category: 'Beverage' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const results = findSimilarRecipes(idx, 'caesar');
    const ids = results.map((r) => r.recipeId);

    for (const id of ['cobb', 'greek', 'chicken-salad', 'potato-salad']) {
      expect(ids).toContain(id);
    }
    for (const id of ['alfredo', 'chicken-soup', 'chicken-tacos', 'garlic-bread', 'lemonade']) {
      expect(ids).not.toContain(id);
    }
    // Every recommendation is a same-family salad.
    expect(results.every((r) => r.reason.includes('Same type · Salad'))).toBe(true);
  });

  it('TACO: Beef Tacos favors tacos and related Tex-Mex, and excludes unrelated dishes', () => {
    const vault = [
      recipe('beef-tacos', 'Beef Tacos', { ings: ['beef', 'tortilla', 'cheese', 'lettuce', 'tomato'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('chicken-tacos', 'Chicken Tacos', { ings: ['chicken', 'tortilla', 'cheese', 'lettuce'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('bean-burrito', 'Bean Burrito', { ings: ['beans', 'tortilla', 'rice', 'cheese'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('cheese-enchiladas', 'Cheese Enchiladas', { ings: ['corn tortilla', 'cheese', 'salsa', 'onion'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('chicken-quesadilla', 'Chicken Quesadilla', { ings: ['chicken', 'tortilla', 'cheese', 'pepper'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('fajitas', 'Fajitas', { ings: ['beef', 'pepper', 'onion', 'tortilla'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('beef-stew', 'Beef Stew', { ings: ['beef', 'potato', 'carrot', 'onion'], cuisine: 'American', category: 'Main Course' }),
      recipe('hot-dog-chili', 'Hot Dog Chili', { ings: ['beef', 'tomato', 'onion', 'beans'], cuisine: 'American', category: 'Main Course' }),
      recipe('stromboli', 'Stromboli', { ings: ['bread', 'pepperoni', 'cheese', 'sauce'], cuisine: 'Italian', category: 'Main Course' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const results = findSimilarRecipes(idx, 'beef-tacos');
    const ids = results.map((r) => r.recipeId);

    for (const id of ['chicken-tacos', 'bean-burrito', 'cheese-enchiladas', 'chicken-quesadilla', 'fajitas']) {
      expect(ids).toContain(id);
    }
    for (const id of ['beef-stew', 'hot-dog-chili', 'stromboli']) {
      expect(ids).not.toContain(id);
    }
    // Same-type taco edges out the related family.
    expect(ids[0]).toBe('chicken-tacos');
  });

  it('SOUP: Chicken Soup favors soup and related stew/chili, and excludes chicken sandwich & pasta', () => {
    const vault = [
      recipe('chicken-soup', 'Chicken Soup', { ings: ['chicken', 'stock', 'carrot', 'celery', 'onion'], cuisine: 'American', category: 'Main Course' }),
      recipe('chicken-noodle-soup', 'Chicken Noodle Soup', { ings: ['chicken', 'stock', 'noodle', 'carrot', 'celery'], cuisine: 'American', category: 'Main Course' }),
      recipe('beef-stew', 'Beef Stew', { ings: ['beef', 'potato', 'carrot', 'onion'], cuisine: 'American', category: 'Main Course' }),
      recipe('turkey-chili', 'Turkey Chili', { ings: ['turkey', 'beans', 'tomato', 'chili'], cuisine: 'American', category: 'Main Course' }),
      recipe('chicken-sandwich', 'Chicken Sandwich', { ings: ['chicken', 'bread', 'mayo', 'lettuce'], cuisine: 'American', category: 'Main Course' }),
      recipe('chicken-alfredo', 'Chicken Alfredo', { ings: ['chicken', 'cream', 'parmesan'], cuisine: 'Italian', category: 'Main Course' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const results = findSimilarRecipes(idx, 'chicken-soup');
    const ids = results.map((r) => r.recipeId);

    for (const id of ['chicken-noodle-soup', 'beef-stew', 'turkey-chili']) {
      expect(ids).toContain(id);
    }
    for (const id of ['chicken-sandwich', 'chicken-alfredo']) {
      expect(ids).not.toContain(id);
    }
    expect(ids[0]).toBe('chicken-noodle-soup'); // same soup family ranks first
  });

  it('DESSERT: Chocolate Cake favors sweet family members and excludes sauce/milkshake/savory mole', () => {
    const vault = [
      recipe('choc-cake', 'Chocolate Cake', { ings: ['flour', 'sugar', 'butter', 'egg', 'cocoa'], cuisine: 'American', category: 'Dessert' }),
      recipe('vanilla-cake', 'Vanilla Cake', { ings: ['flour', 'sugar', 'butter', 'egg', 'vanilla'], cuisine: 'American', category: 'Dessert' }),
      recipe('dessert-brownies', 'Dessert Brownies', { ings: ['flour', 'sugar', 'butter', 'egg', 'chocolate'], cuisine: 'American', category: 'Dessert' }),
      recipe('apple-pie', 'Apple Pie', { ings: ['flour', 'butter', 'apple', 'sugar', 'cinnamon'], cuisine: 'American', category: 'Dessert' }),
      recipe('choc-cookies', 'Chocolate Cookies', { ings: ['flour', 'sugar', 'butter', 'egg', 'chocolate'], cuisine: 'American', category: 'Dessert' }),
      recipe('choc-sauce', 'Chocolate Sauce', { ings: ['chocolate', 'cream', 'sugar'], cuisine: 'American', category: 'Condiment' }),
      recipe('choc-milkshake', 'Chocolate Milkshake', { ings: ['milk', 'chocolate', 'ice cream', 'sugar'], cuisine: 'American', category: 'Beverage' }),
      recipe('chicken-mole', 'Chicken Mole', { ings: ['chicken', 'chocolate', 'chilies', 'onion'], cuisine: 'Mexican', category: 'Main Course' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const results = findSimilarRecipes(idx, 'choc-cake');
    const ids = results.map((r) => r.recipeId);

    for (const id of ['vanilla-cake', 'dessert-brownies', 'apple-pie', 'choc-cookies']) {
      expect(ids).toContain(id);
    }
    for (const id of ['choc-sauce', 'choc-milkshake', 'chicken-mole']) {
      expect(ids).not.toContain(id);
    }
    expect(ids[0]).toBe('vanilla-cake'); // same cake family ranks first
  });

  it('DRINK: Cucumber Lime Agua Fresca favors other drinks and excludes lime sauce/dish/pie', () => {
    const vault = [
      recipe('agua-fresca', 'Cucumber Lime Agua Fresca', { ings: ['cucumber', 'lime', 'sugar', 'water'], cuisine: 'Mexican', category: 'Beverage' }),
      recipe('lemonade', 'Lemonade', { ings: ['lemon', 'sugar', 'water'], cuisine: 'American', category: 'Beverage' }),
      recipe('smoothie', 'Berry Smoothie', { ings: ['berry', 'yogurt', 'sugar'], cuisine: 'American', category: 'Beverage' }),
      recipe('lime-sauce', 'Lime Sauce', { ings: ['lime', 'sugar', 'butter'], cuisine: 'Mexican', category: 'Condiment' }),
      recipe('lime-chicken', 'Lime Chicken', { ings: ['lime', 'chicken', 'garlic'], cuisine: 'Mexican', category: 'Main Course' }),
      recipe('lime-pie', 'Lime Pie', { ings: ['lime', 'sugar', 'butter', 'egg'], cuisine: 'Mexican', category: 'Dessert' }),
    ];
    const idx = buildRecipeRelationshipIndex(vault);
    const results = findSimilarRecipes(idx, 'agua-fresca');
    const ids = results.map((r) => r.recipeId);

    for (const id of ['lemonade', 'smoothie']) {
      expect(ids).toContain(id);
    }
    for (const id of ['lime-sauce', 'lime-chicken', 'lime-pie']) {
      expect(ids).not.toContain(id);
    }
    expect(ids.every((id) => id === 'lemonade' || id === 'smoothie')).toBe(true);
  });
});

describe('culinarySimilarity: single authority — Ask My Kitchen delegates to it', () => {
  it('similarToRecipeId results come from the same family-based authority', () => {
    const recipes = [
      recipe('caesar', 'Chicken Caesar Salad', { ings: ['romaine', 'chicken breast', 'parmesan', 'garlic', 'croutons'], cuisine: 'American', category: 'Main Course' }),
      recipe('greek', 'Greek Salad', { ings: ['romaine', 'feta', 'cucumber', 'tomato', 'olive'], cuisine: 'American', category: 'Main Course' }),
      recipe('alfredo', 'Chicken Alfredo', { ings: ['chicken breast', 'parmesan', 'heavy cream', 'garlic'], cuisine: 'American', category: 'Main Course' }),
    ];
    // searchKitchenRecipes delegates similarToRecipeId to findSimilarRecipes, so a
    // salad source surfaces a fellow salad and excludes the unrelated pasta even
    // though they share chicken + parmesan + garlic.
    const results = searchKitchenRecipes(recipes, { similarToRecipeId: 'caesar' });
    const ids = results.map((r) => r.recipeIdentity);
    expect(ids).toContain('greek');
    expect(ids).not.toContain('alfredo');
    expect(results.every((r) => r.similarity)).toBe(true);
  });
});
