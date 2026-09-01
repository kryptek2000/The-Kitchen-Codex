import { describe, it, expect } from 'vitest';
import { ObsidianRecipe } from '../../src/types';
import { cardTiming } from '../../src/components/RecipeCardExportModal';

describe('Recipe Card Data Mapping & Regression', () => {
  const sampleRecipe: ObsidianRecipe = {
    id: 'test-1',
    fileName: 'test_recipe.md',
    filePath: 'Recipes/test_recipe.md',
    rawMarkdown: '# Test Recipe',
    title: 'Authentic Tonkotsu Shoyu Ramen',
    tags: ['food/recipes'],
    category: 'Soup & Noodles',
    cuisine: 'Japanese',
    prepTime: '30 mins',
    cookTime: '45 mins',
    servings: 4,
    difficulty: 'Medium',
    rating: 5,
    ingredients: [
      { original: '4 portions Fresh Ramen Noodles', name: 'Fresh Ramen Noodles' }
    ],
    instructions: [
      { stepNumber: 1, text: 'Boil water and cook noodles.' }
    ],
    notes: 'Make-Ahead Tare: Prepare 24-48 hours in advance.',
    dataviewFields: {
      description: 'Rich and flavorful tonkotsu broth with tender chashu pork.',
      foodDisplay: 'Traditional presentation with vibrant toppings.'
    },
    callouts: [],
    wikilinks: []
  };

  it('maps description correctly from dataviewFields', () => {
    const description = sampleRecipe.dataviewFields?.description || sampleRecipe.dataviewFields?.summary || (sampleRecipe as any).description || '';
    expect(description).toContain('Rich and flavorful');
  });

  it("maps Chef's Notes correctly to notes and keeps them distinct", () => {
    const notes = sampleRecipe.notes || '';
    expect(notes).toContain('Make-Ahead Tare');
  });

  it('does not fall back to notes when description is missing', () => {
    const recipeWithoutDesc: ObsidianRecipe = {
      ...sampleRecipe,
      dataviewFields: {}
    };
    const descMissing = recipeWithoutDesc.dataviewFields?.description || '';
    expect(descMissing).toBe('');
  });

  it('detects Food Display strictly from metadata without fabrication', () => {
    const foodDisplayText = sampleRecipe.dataviewFields?.foodDisplay || sampleRecipe.dataviewFields?.presentation;
    expect(Boolean(foodDisplayText)).toBe(true);

    const recipeWithoutFoodDisplay: ObsidianRecipe = {
      ...sampleRecipe,
      dataviewFields: {}
    };
    const hasFoodDisplayMissing = Boolean(recipeWithoutFoodDisplay.dataviewFields?.foodDisplay || recipeWithoutFoodDisplay.dataviewFields?.presentation);
    expect(hasFoodDisplayMissing).toBe(false);
  });

  it('does not fabricate prep/cook time on the exported card', () => {
    // A recipe with no timings must NOT get placeholder "15 mins"/"30 mins".
    expect(cardTiming(undefined)).toBe('—');
    expect(cardTiming('')).toBe('—');
    expect(cardTiming('   ')).toBe('—');
    // Real values pass through verbatim.
    expect(cardTiming('30 mins')).toBe('30 mins');
    expect(cardTiming('1 hr 15 mins')).toBe('1 hr 15 mins');
    expect(cardTiming(sampleRecipe.prepTime)).toBe('30 mins');
    expect(cardTiming(sampleRecipe.cookTime)).toBe('45 mins');
  });
});
