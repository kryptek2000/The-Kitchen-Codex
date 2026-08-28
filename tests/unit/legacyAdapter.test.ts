import { describe, it, expect } from 'vitest';
import { ObsidianRecipe } from '../../src/types';
import { obsidianToCanonicalRecipe, canonicalToObsidianRecipe } from '../../src/schema';

describe('Legacy Compatibility Adapter', () => {
  const legacyRecipe: ObsidianRecipe = {
    id: 'ramen-1',
    fileName: 'Tonkotsu_Ramen.md',
    filePath: 'Recipes/Japanese/Tonkotsu_Ramen.md',
    rawMarkdown: '# Tonkotsu Ramen\n\nDelicious rich broth.',
    title: 'Tonkotsu Ramen',
    tags: ['japanese', 'noodles', 'soup'],
    category: 'Soup & Noodles',
    cuisine: 'Japanese',
    prepTime: '30 mins',
    cookTime: '1 hr 15 mins',
    totalTime: '1 hr 45 mins',
    servings: 4,
    difficulty: 'Medium',
    rating: 5,
    source: 'https://example.com/ramen',
    image: 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624',
    ingredients: [
      {
        original: '4 portions Fresh Ramen Noodles',
        name: 'Fresh Ramen Noodles',
        amount: 4,
        unit: 'portion',
      },
      {
        original: '2 tbsp [[Tare Sauce|Ramen Tare]]',
        name: 'Tare Sauce',
        amount: 2,
        unit: 'tbsp',
        wikilink: '[[Tare Sauce|Ramen Tare]]',
        wikilinkTarget: 'Tare Sauce',
        wikilinkAlias: 'Ramen Tare',
      },
    ],
    instructions: [
      { stepNumber: 1, text: 'Boil rich broth for hours.', timerMinutes: 60, isCompleted: false },
      { stepNumber: 2, text: 'Cook noodles in boiling water for 90 seconds.', timerMinutes: 2, isCompleted: false },
    ],
    notes: 'Prepare the tare 24 hours in advance.',
    callouts: [
      { type: 'tip', title: 'Broth Clarity', content: 'Skim impurities constantly.' },
    ],
    dataviewFields: {
      brothType: 'Pork bone rich emulsion',
      originRegion: 'Fukuoka, Japan',
    },
    wikilinks: ['Tare Sauce', 'Chashu Pork'],
    isFavorite: true,
  };

  it('losslessly converts ObsidianRecipe to CanonicalRecipe and back', () => {
    const canonical = obsidianToCanonicalRecipe(legacyRecipe);

    expect(canonical.identity.id).toBe(legacyRecipe.id);
    expect(canonical.identity.title).toBe(legacyRecipe.title);
    expect(canonical.timings.prepMinutes).toBe(30);
    expect(canonical.timings.cookMinutes).toBe(75);
    expect(canonical.timings.totalMinutes).toBe(105);
    expect(canonical.metadata.rating).toBe(5);
    expect(canonical.metadata.isFavorite).toBe(true);
    expect(canonical.ingredients.length).toBe(2);
    expect(canonical.instructions.length).toBe(2);
    expect(canonical.callouts.length).toBe(1);
    expect(canonical.dataviewFields.brothType).toBe('Pork bone rich emulsion');

    const convertedBack = canonicalToObsidianRecipe(canonical);

    expect(convertedBack.id).toBe(legacyRecipe.id);
    expect(convertedBack.title).toBe(legacyRecipe.title);
    expect(convertedBack.prepTime).toBe('30 mins');
    expect(convertedBack.cookTime).toBe('1 hr 15 mins');
    expect(convertedBack.totalTime).toBe('1 hr 45 mins');
    expect(convertedBack.servings).toBe(4);
    expect(convertedBack.difficulty).toBe('Medium');
    expect(convertedBack.rating).toBe(5);
    expect(convertedBack.isFavorite).toBe(true);
    expect(convertedBack.ingredients.length).toBe(2);
    expect(convertedBack.instructions.length).toBe(2);
    expect(convertedBack.notes).toBe(legacyRecipe.notes);
    expect(convertedBack.callouts).toEqual(legacyRecipe.callouts);
    expect(convertedBack.dataviewFields).toEqual(legacyRecipe.dataviewFields);
    expect(convertedBack.wikilinks).toEqual(legacyRecipe.wikilinks);
  });
});
