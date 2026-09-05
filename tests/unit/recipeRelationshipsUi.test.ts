import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildRecipeRelationshipIndex,
  recipeIdentity,
  getRecipesUsingIngredient,
} from '../../src/utils/recipeRelationships';
import {
  RecipeRelationshipsPanel,
  selectSimilarRelations,
  formatSimilarityPercent,
} from '../../src/components/RecipeRelationshipsPanel';
import {
  IngredientUsageModal,
  selectIngredientRecipes,
} from '../../src/components/IngredientUsageModal';
import { ObsidianRecipe, ParsedIngredient } from '../../src/types';

function mkRecipe(
  id: string,
  title: string,
  ingOrigs: string[],
  extra: Partial<ObsidianRecipe> = {}
): ObsidianRecipe {
  const ingredients: ParsedIngredient[] = ingOrigs.map((original) => ({ original } as ParsedIngredient));
  return {
    id,
    fileName: `${id}.md`,
    filePath: `${id}.md`,
    rawMarkdown: '',
    title,
    tags: [],
    category: 'Main Course',
    cuisine: 'Italian',
    difficulty: 'Medium',
    rating: 5,
    ingredients,
    instructions: [],
    callouts: [],
    dataviewFields: {},
    wikilinks: [],
    ...extra,
  } as unknown as ObsidianRecipe;
}

function mapByIdentity(recipes: ObsidianRecipe[]): Map<string, ObsidianRecipe> {
  const map = new Map<string, ObsidianRecipe>();
  for (const r of recipes) map.set(recipeIdentity(r), r);
  return map;
}

// Step 6 realistic mini-vault dataset.
function miniVault(): ObsidianRecipe[] {
  return [
    mkRecipe('chicken-alfredo', 'Chicken Alfredo', [
      '2 chicken breast',
      '1 cup heavy cream',
      '1/2 cup parmesan cheese',
      '2 cloves garlic',
    ]),
    mkRecipe('creamy-garlic-chicken', 'Creamy Garlic Chicken', [
      '1 chicken breast',
      '1/2 cup heavy cream',
      '2 cloves garlic',
      '1 onion, diced',
    ]),
    mkRecipe('garlic-bread', 'Garlic Bread', ['1 loaf bread', '2 tbsp butter', '3 cloves garlic']),
    mkRecipe('pancakes', 'Pancakes', ['1 cup flour', '2 eggs', '1 cup milk', '1 tbsp sugar']),
  ];
}

// A coherent Tex-Mex culinary vault for the "Similar Recipes" surface. Unlike
// `miniVault` (which deliberately mixes unrelated dish families to exercise the
// ingredient index), this group is one culinary neighborhood, so the panel can
// demonstrably rank same-family > related-family and gate out the unrelated beef
// stew even though it shares "beef" with the source.
function culinaryVault(): ObsidianRecipe[] {
  return [
    mkRecipe('beef-tacos', 'Beef Tacos', ['beef', 'tortilla', 'cheese', 'lettuce', 'tomato'], { cuisine: 'Mexican' }),
    mkRecipe('chicken-tacos', 'Chicken Tacos', ['chicken', 'tortilla', 'cheese', 'lettuce'], { cuisine: 'Mexican' }),
    mkRecipe('bean-burrito', 'Bean Burrito', ['beans', 'tortilla', 'rice', 'cheese'], { cuisine: 'Mexican' }),
    mkRecipe('cheese-enchiladas', 'Cheese Enchiladas', ['corn tortilla', 'cheese', 'salsa', 'onion'], { cuisine: 'Mexican' }),
    mkRecipe('beef-stew', 'Beef Stew', ['beef', 'potato', 'carrot', 'onion'], { cuisine: 'American' }),
  ];
}

describe('relationship UI: index lifecycle', () => {
  it('builds a relationship index from the loaded recipe collection', () => {
    const recipes = miniVault();
    const index = buildRecipeRelationshipIndex(recipes);
    expect(getRecipesUsingIngredient(index, 'garlic')).toEqual([
      'chicken-alfredo',
      'creamy-garlic-chicken',
      'garlic-bread',
    ]);
  });

  it('recomputes when the loaded recipe collection changes', () => {
    const base = miniVault();
    const before = buildRecipeRelationshipIndex(base);
    expect(getRecipesUsingIngredient(before, 'garlic').length).toBe(3);

    // Add a recipe using garlic -> index must reflect it.
    const added = [...base, mkRecipe('garlic-soup', 'Garlic Soup', ['2 cloves garlic', 'broth'])];
    const after = buildRecipeRelationshipIndex(added);
    expect(getRecipesUsingIngredient(after, 'garlic')).toContain('garlic-soup');
    expect(getRecipesUsingIngredient(after, 'garlic').length).toBe(4);

    // Removing a recipe removes its membership.
    const removed = base.filter((r) => r.id !== 'garlic-bread');
    const afterRemove = buildRecipeRelationshipIndex(removed);
    expect(getRecipesUsingIngredient(afterRemove, 'garlic')).not.toContain('garlic-bread');
  });
});

describe('relationship UI: similar recipes', () => {
  it('ranks same-family first, then related-family, and gates out an unrelated known family', () => {
    const recipes = culinaryVault();
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    const relations = selectSimilarRelations('beef-tacos', index, map);

    expect(relations.map((r) => r.recipe.title)).toEqual([
      'Chicken Tacos',
      'Bean Burrito',
      'Cheese Enchiladas',
    ]);
    // Same-family taco edges out the related Mexican dishes.
    expect(relations[0].sim.reason).toContain('Same type · Taco');
    expect(relations[0].sim.sharedCount).toBe(3);
    expect(relations[1].sim.reason).toContain('Mexican');
    // Beef Stew is a known-and-unrelated family (stew vs taco) and is gated out
    // even though it shares "beef" with the source.
    expect(relations.some((r) => r.recipe.title === 'Beef Stew')).toBe(false);
  });

  it('resolves each similar recipe title from the stable recipe identity', () => {
    const recipes = culinaryVault();
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    const relations = selectSimilarRelations('beef-tacos', index, map);
    // The recipe objects come from the live collection (identity-resolved).
    expect(relations.some((r) => r.recipe.id === 'chicken-tacos')).toBe(true);
    expect(relations.some((r) => r.recipe.id === 'bean-burrito')).toBe(true);
  });

  it('returns an empty array when there are no similar recipes', () => {
    const only = [mkRecipe('lone', 'Lone Recipe', ['salt', 'pepper'])];
    const index = buildRecipeRelationshipIndex(only);
    const relations = selectSimilarRelations('lone', index, mapByIdentity(only));
    expect(relations).toEqual([]);
  });
});

describe('relationship UI: ingredient lookup', () => {
  it('returns recipes using the same exact relationship key (current omitted)', () => {
    const recipes = miniVault();
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    const forGarlic = selectIngredientRecipes(index, 'garlic', 'chicken-alfredo', map);
    expect(forGarlic.map((r) => r.id)).toEqual(['creamy-garlic-chicken', 'garlic-bread']);

    const forCream = selectIngredientRecipes(index, '1 cup heavy cream', 'chicken-alfredo', map);
    expect(forCream.map((r) => r.id)).toEqual(['creamy-garlic-chicken']);
  });

  it('false-positive: egg must NOT return the eggplant recipe', () => {
    const recipes = [
      mkRecipe('egg-dish', 'Egg Dish', ['2 eggs']),
      mkRecipe('eggplant-dish', 'Eggplant Dish', ['1 eggplant']),
    ];
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    expect(selectIngredientRecipes(index, 'egg', 'egg-dish', map)).toEqual([]);
    expect(selectIngredientRecipes(index, 'eggs', 'egg-dish', map)).toEqual([]);
    expect(selectIngredientRecipes(index, 'eggplant', 'eggplant-dish', map)).toEqual([]);
    expect(selectIngredientRecipes(index, 'eggplant', 'egg-dish', map).map((r) => r.id)).toEqual(['eggplant-dish']);
  });

  it('wikilink target authority: same alias cannot cross distinct targets', () => {
    const recipes = [
      mkRecipe('C', 'C Recipe', ['[[Chicken Breast|chicken]]']),
      mkRecipe('D', 'D Recipe', ['[[Chicken Thigh|chicken]]']),
    ];
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    // C uses chicken breast; its own lookup (current excluded) finds only itself -> [].
    expect(selectIngredientRecipes(index, '[[Chicken Breast|chicken]]', 'C', map)).toEqual([]);
    // D queries the breast ingredient -> finds C (but not itself).
    expect(selectIngredientRecipes(index, '[[Chicken Breast|chicken]]', 'D', map).map((r) => r.id)).toEqual(['C']);
    // Thigh never returns C (distinct target).
    expect(selectIngredientRecipes(index, '[[Chicken Thigh|chicken]]', 'C', map).map((r) => r.id)).toEqual(['D']);
    expect(selectIngredientRecipes(index, '[[Chicken Thigh|chicken]]', 'D', map)).toEqual([]);
  });

  it('returns empty when the ingredient is only used by the current recipe', () => {
    const recipes = miniVault();
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);
    expect(selectIngredientRecipes(index, 'eggs', 'pancakes', map)).toEqual([]);
  });

  it('safely skips unresolvable identities (does not crash)', () => {
    const recipes = miniVault();
    const index = buildRecipeRelationshipIndex(recipes);
    // A map that cannot resolve the returned identity -> filtered out, no throw.
    const emptyMap = new Map<string, ObsidianRecipe>();
    expect(selectIngredientRecipes(index, 'garlic', 'chicken-alfredo', emptyMap)).toEqual([]);
    expect(selectSimilarRelations('chicken-alfredo', index, emptyMap)).toEqual([]);
  });
});

describe('relationship UI: nav + immutability', () => {
  it('resolves similar recipes to live recipe objects by stable identity', () => {
    // NOTE: static rendering cannot execute click handlers or effects, so this
    // verifies the DATA the panel would pass to onSelectRecipe (identity
    // resolution), not the click wiring itself. Interaction coverage is via the
    // pure selectors, not a browser harness.
    const recipes = culinaryVault();
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    const relations = selectSimilarRelations('beef-tacos', index, map);
    const chickenId = 'chicken-tacos';
    const resolved = relations.find((r) => r.recipe.id === chickenId);

    // The selector hands back the LIVE recipe object from the loaded collection,
    // so the panel's onSelectRecipe(related) navigates with the real record.
    expect(resolved?.recipe).toBeDefined();
    expect(resolved?.recipe.id).toBe(chickenId);
    // And the identity used to resolve is the stable Step 6 identity.
    expect(map.get(chickenId)?.title).toBe('Chicken Tacos');
  });

  it('does not mutate the input recipe ingredient data', () => {
    const recipes = miniVault();
    const snapshot = JSON.stringify(recipes);
    buildRecipeRelationshipIndex(recipes);
    selectSimilarRelations('chicken-alfredo', buildRecipeRelationshipIndex(recipes), mapByIdentity(recipes));
    selectIngredientRecipes(buildRecipeRelationshipIndex(recipes), 'garlic', 'chicken-alfredo', mapByIdentity(recipes));
    expect(JSON.stringify(recipes)).toBe(snapshot);
  });
});

describe('relationship UI: static render smoke tests (no AI / no server)', () => {
  it('renders the similar recipes list with culinary reasons', () => {
    const recipes = culinaryVault();
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    const html = renderToStaticMarkup(
      React.createElement(RecipeRelationshipsPanel, {
        recipe: recipes[0],
        index,
        recipeByIdentity: map,
        onSelectRecipe: () => {},
      })
    );
    expect(html).toContain('Chicken Tacos');
    expect(html).toContain('Bean Burrito');
    expect(html).toContain('3 shared ingredients');
    expect(html).toContain('Same type · Taco');
    // The displayed value is now the CULINARY relevance score (0.75), not raw
    // ingredient Jaccard.
    expect(html).toContain('75%');
    // Beef Stew is a known-and-unrelated family (stew) and is hard-gated out.
    expect(html).not.toContain('Beef Stew');
  });

  it('renders a restrained empty state for no similar recipes', () => {
    const only = [mkRecipe('lone', 'Lone Recipe', ['salt'])];
    const html = renderToStaticMarkup(
      React.createElement(RecipeRelationshipsPanel, {
        recipe: only[0],
        index: buildRecipeRelationshipIndex(only),
        recipeByIdentity: mapByIdentity(only),
        onSelectRecipe: () => {},
      })
    );
    expect(html).toContain('No strongly similar recipes found.');
  });

  it('renders recipes using a tapped ingredient (current omitted)', () => {
    const recipes = miniVault();
    const index = buildRecipeRelationshipIndex(recipes);
    const map = mapByIdentity(recipes);

    const html = renderToStaticMarkup(
      React.createElement(IngredientUsageModal, {
        isOpen: true,
        display: 'garlic',
        query: 'garlic',
        currentIdentity: 'chicken-alfredo',
        index,
        recipeByIdentity: map,
        onClose: () => {},
        onSelectRecipe: () => {},
      })
    );
    expect(html).toContain('Creamy Garlic Chicken');
    expect(html).toContain('Garlic Bread');
    expect(html).not.toContain('Chicken Alfredo');
  });

  it('renders the empty state when an ingredient is used by no other recipe', () => {
    const recipes = miniVault();
    const html = renderToStaticMarkup(
      React.createElement(IngredientUsageModal, {
        isOpen: true,
        display: 'eggs',
        query: 'eggs',
        currentIdentity: 'pancakes',
        index: buildRecipeRelationshipIndex(recipes),
        recipeByIdentity: mapByIdentity(recipes),
        onClose: () => {},
        onSelectRecipe: () => {},
      })
    );
    expect(html).toContain('Not used by other recipes.');
  });

  it("uses the stable recipe identity (id ?? filePath ?? fileName) to resolve similar recipes", () => {
    // A recipe whose `id` is absent but which has a unique filePath must still be
    // found/similar via its identity; the panel never relies on `title` alone.
    const recipes = [
      mkRecipe('has-id', 'Has Id', ['garlic', 'butter']),
      { ...mkRecipe('', 'No Id', ['garlic', 'bread']), filePath: 'Folder/No Id.md', fileName: 'No Id.md' } as ObsidianRecipe,
    ];
    const map = mapByIdentity(recipes);
    const index = buildRecipeRelationshipIndex(recipes);
    // The second recipe's index key is its filePath identity.
    const relations = selectSimilarRelations(recipeIdentity(recipes[0]), index, map);
    expect(relations.some((r) => r.recipe.title === 'No Id')).toBe(true);
  });
});

describe('relationship UI: percent formatting guard', () => {
  it('never displays a genuine positive similarity as 0%', () => {
    expect(formatSimilarityPercent(0)).toBe('0%');
    expect(formatSimilarityPercent(0.004)).toBe('<1%');
    expect(formatSimilarityPercent(0.0049)).toBe('<1%');
    expect(formatSimilarityPercent(0.05)).toBe('5%');
    expect(formatSimilarityPercent(0.6)).toBe('60%');
    expect(formatSimilarityPercent(1)).toBe('100%');
  });
});
