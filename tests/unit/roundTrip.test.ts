import { describe, it, expect } from 'vitest';
import { parseObsidianRecipeMarkdown, serializeRecipeToObsidianMarkdown, renderIngredientLine } from '../../src/utils/markdownParser';
import { obsidianToCanonicalRecipe, canonicalToObsidianRecipe, validateCanonicalRecipe } from '../../src/schema';

describe('Markdown to Canonical Schema Round-Trip Serialization & Integrity Tests', () => {
  const sampleMarkdown = `---
title: Authentic Thai Green Curry
tags:
  - thai
  - curry
  - dinner
  - spicy
cuisine: Thai
category: Main Dishes
servings: 4
prepTime: 20 mins
cookTime: 25 mins
totalTime: 45 mins
difficulty: Medium
rating: 5
source: https://example.com/green-curry
author: Chef Somchai
customField: preserved-value
---

# Authentic Thai Green Curry

A fragrant, creamy coconut milk curry with tender chicken and bamboo shoots.

originRegion:: Central Thailand
spiceRating:: 4/5

> [!tip] Fresh Herbs
> Add fresh Thai basil leaves right at the very end with heat turned off to preserve essential oils.

## Ingredients
- [x] 500g [[Chicken Thighs]], sliced into bite-size pieces
- [ ] 2 tbsp [[Thai Green Curry Paste|Green Curry Paste]]
- [ ] 400ml [[Coconut Milk]]
- [ ] 1 cup [[Bamboo Shoots]]
- [x] 2 tbsp [[Fish Sauce]]
- [ ] 1 tbsp Palm Sugar
- [ ] 1 cup Fresh Thai Sweet Basil leaves (optional)

## Instructions
1. Heat 3 tbsp of thick coconut cream in a wok over medium heat until oil separates.
2. Add the green curry paste and fry for 2 minutes until aromatic.
3. Add chicken slices and cook until no longer pink outside.
4. Pour in remaining coconut milk, fish sauce, and palm sugar. Simmer for 15 minutes.
5. Stir in bamboo shoots and simmer for 5 more minutes.
6. Turn off heat and fold in fresh Thai basil leaves.

## Notes
Serve immediately over steamed Jasmine Rice.
`;

  it('performs full round-trip from Raw Markdown -> Parsed -> Canonical -> Legacy -> Serialized Markdown', () => {
    // Step 1: Parse Markdown to ObsidianRecipe
    const parsedRecipe = parseObsidianRecipeMarkdown(sampleMarkdown, 'Green_Curry.md', 'Recipes/Thai/Green_Curry.md');
    expect(parsedRecipe).not.toBeNull();
    if (!parsedRecipe) return;

    expect(parsedRecipe.title).toBe('Authentic Thai Green Curry');
    expect(parsedRecipe.ingredients.length).toBe(7);
    expect(parsedRecipe.instructions.length).toBe(6);

    // Step 2: Convert to Canonical Schema v1
    const canonical = obsidianToCanonicalRecipe(parsedRecipe);
    expect(canonical.schemaVersion).toBe(1);
    expect(canonical.identity.title).toBe('Authentic Thai Green Curry');
    expect(canonical.timings.prepMinutes).toBe(20);
    expect(canonical.timings.cookMinutes).toBe(25);
    expect(canonical.timings.totalMinutes).toBe(45);
    expect(canonical.metadata.tags).toContain('thai');
    expect(canonical.metadata.tags).toContain('curry');

    // Validate schema
    const validation = validateCanonicalRecipe(canonical);
    expect(validation.isValid).toBe(true);

    // Step 3: Convert back to ObsidianRecipe
    const roundTripRecipe = canonicalToObsidianRecipe(canonical);
    expect(roundTripRecipe.title).toBe('Authentic Thai Green Curry');
    expect(roundTripRecipe.servings).toBe(4);
    expect(roundTripRecipe.prepTime).toBe('20 mins');
    expect(roundTripRecipe.cookTime).toBe('25 mins');

    // Step 4: Serialize back to Markdown
    const serialized = serializeRecipeToObsidianMarkdown(roundTripRecipe);

    // Verify Custom Frontmatter Preservation
    expect(serialized).toContain('author: Chef Somchai');
    expect(serialized).toContain('customField: preserved-value');

    // Verify Dataview Inline Fields Preservation
    expect(serialized).toContain('originRegion:: Central Thailand');
    expect(serialized).toContain('spiceRating:: 4/5');

    // Verify Exact Wikilink Preservation & Checklist State Preservation
    expect(serialized).toContain('- [x] 500g [[Chicken Thighs]]');
    expect(serialized).toContain('- [ ] 2 tbsp [[Thai Green Curry Paste|Green Curry Paste]]');
    expect(serialized).toContain('- [ ] 400ml [[Coconut Milk]]');
    expect(serialized).toContain('- [x] 2 tbsp [[Fish Sauce]]');

    // Verify Plain Ingredient Non-Generation of Wikilinks
    expect(serialized).toContain('- [ ] 1 tbsp Palm Sugar');
    expect(serialized).not.toContain('[[Palm Sugar]]');
    expect(serialized).not.toContain('[[Fresh Thai Sweet Basil leaves]]');

    // Step 5: Re-parse serialized markdown and verify data stability
    const reparsed = parseObsidianRecipeMarkdown(serialized, 'Green_Curry.md', 'Recipes/Thai/Green_Curry.md');
    expect(reparsed).not.toBeNull();
    if (!reparsed) return;

    expect(reparsed.title).toBe(parsedRecipe.title);
    expect(reparsed.servings).toBe(parsedRecipe.servings);
    expect(reparsed.ingredients.length).toBe(parsedRecipe.ingredients.length);
    expect(reparsed.instructions.length).toBe(parsedRecipe.instructions.length);

    // Re-verify Dataview & Custom Frontmatter on reparsed note
    expect(reparsed.dataviewFields['originRegion']).toBe('Central Thailand');
    expect(reparsed.dataviewFields['spiceRating']).toBe('4/5');
    expect(reparsed.frontmatter?.author).toBe('Chef Somchai');
    expect(reparsed.frontmatter?.customField).toBe('preserved-value');

    // Re-verify checklist state on reparsed ingredients
    expect(reparsed.ingredients[0].isChecked).toBe(true);
    expect(reparsed.ingredients[0].wikilinkTarget).toBe('Chicken Thighs');
    expect(reparsed.ingredients[1].isChecked).toBe(false);
    expect(reparsed.ingredients[1].wikilinkTarget).toBe('Thai Green Curry Paste');
    expect(reparsed.ingredients[1].wikilinkAlias).toBe('Green Curry Paste');
  });

  it('preserves top-level legacy calories into canonical nutrition block and back', () => {
    const markdownWithCalories = `---
title: Quick Oatmeal
calories: 320
---

# Quick Oatmeal

## Ingredients
- [ ] 1 cup Rolled Oats
- [ ] 2 cups Water
`;

    const parsed = parseObsidianRecipeMarkdown(markdownWithCalories, 'Oatmeal.md');
    expect(parsed.calories).toBe(320);

    const canonical = obsidianToCanonicalRecipe(parsed);
    expect(canonical.nutrition).toBeDefined();
    expect(canonical.nutrition?.calories).toBe(320);

    const backToLegacy = canonicalToObsidianRecipe(canonical);
    expect(backToLegacy.calories).toBe(320);

    const serialized = serializeRecipeToObsidianMarkdown(backToLegacy);
    expect(serialized).toContain('calories: 320');
  });

  it('does NOT fabricate metadata (images, created dates, total_time) on notes lacking them', () => {
    const minimalMarkdown = `---
title: Simple Salted Eggs
tags:
  - breakfast
---

# Simple Salted Eggs

## Ingredients
- [ ] 2 Eggs
- [ ] 1 pinch Salt

## Instructions
1. Boil eggs for 7 minutes.
`;

    const parsed = parseObsidianRecipeMarkdown(minimalMarkdown, 'Eggs.md');
    // Ensure image is undefined and not populated with Unsplash URL in persisted data
    expect(parsed.image).toBeUndefined();

    const serialized = serializeRecipeToObsidianMarkdown(parsed);
    // Serialized frontmatter must NOT contain fabricated image URL or created date
    expect(serialized).not.toContain('image: https://images.unsplash.com');
    expect(serialized).not.toContain('image:');
    expect(serialized).not.toContain('created:');
    expect(serialized).not.toContain('total_time:');
  });

  it('resolves Dataview standard fields case-insensitively while preserving original key casing during serialization', () => {
    const markdownWithMixedCasing = `---
title: Classic Carbonara
tags:
  - pasta
  - italian
---

# Classic Carbonara

Cuisine:: Italian
Category:: Pasta & Mains
DIFFICULTY:: Medium
RATING:: 5
IMAGE:: https://images.unsplash.com/photo-carbonara
customChef:: Mario

## Ingredients
- [ ] 400g [[Spaghetti]]
- [ ] 150g [[Guanciale]]

## Instructions
1. Crisp the guanciale and mix with eggs and pecorino.
`;

    // Parse (Load path)
    const parsed = parseObsidianRecipeMarkdown(markdownWithMixedCasing, 'Carbonara.md');
    
    // Check standard fields are resolved case-insensitively
    expect(parsed.cuisine).toBe('Italian');
    expect(parsed.category).toBe('Pasta & Mains');
    expect(parsed.difficulty).toBe('Medium');
    expect(parsed.rating).toBe(5);
    expect(parsed.image).toBe('https://images.unsplash.com/photo-carbonara');

    // Serialize (Save path)
    const serialized = serializeRecipeToObsidianMarkdown(parsed);

    // Verify original Dataview key casing is preserved intact in serialized markdown
    expect(serialized).toContain('Cuisine:: Italian');
    expect(serialized).toContain('Category:: Pasta & Mains');
    expect(serialized).toContain('DIFFICULTY:: Medium');
    expect(serialized).toContain('RATING:: 5');
    expect(serialized).toContain('IMAGE:: https://images.unsplash.com/photo-carbonara');
    expect(serialized).toContain('customChef:: Mario');
  });

  it('exercises full production-boundary load and save cycle through CanonicalRecipe Schema', () => {
    const rawNote = `---
title: Roman Cacio e Pepe
tags:
  - italian
  - quick
prepTime: 5 mins
cookTime: 10 mins
totalTime: 15 mins
author: Nonna Maria
date: 2026-01-15
---

# Roman Cacio e Pepe

Region:: Lazio

## Ingredients
- [ ] 200g [[Pecorino Romano]]
- [x] 1 tbsp [[Black Pepper|Cracked Black Peppercorns]]
- [ ] 300g Tonnarelli

## Instructions
1. Toast pepper, cook pasta, emulsify with starchy pasta water and cheese.
`;

    // Production Load Path: Markdown -> parseObsidianRecipeMarkdown (which normalizes via CanonicalRecipe)
    const loadedRecipe = parseObsidianRecipeMarkdown(rawNote, 'Cacio_e_Pepe.md');
    
    // Check Canonical Invariants on loaded model
    expect(loadedRecipe.title).toBe('Roman Cacio e Pepe');
    expect(loadedRecipe.prepTime).toBe('5 mins');
    expect(loadedRecipe.cookTime).toBe('10 mins');
    expect(loadedRecipe.totalTime).toBe('15 mins');
    expect(loadedRecipe.ingredients.length).toBe(3);
    expect(loadedRecipe.ingredients[1].wikilinkTarget).toBe('Black Pepper');
    expect(loadedRecipe.ingredients[1].wikilinkAlias).toBe('Cracked Black Peppercorns');
    expect(loadedRecipe.ingredients[1].isChecked).toBe(true);

    // Production Save Path: ObsidianRecipe -> serializeRecipeToObsidianMarkdown (which normalizes via CanonicalRecipe)
    const savedMarkdown = serializeRecipeToObsidianMarkdown(loadedRecipe);

    // Re-parse saved markdown to verify round-trip stability
    const reloadedRecipe = parseObsidianRecipeMarkdown(savedMarkdown, 'Cacio_e_Pepe.md');
    expect(reloadedRecipe.title).toBe('Roman Cacio e Pepe');
    expect(reloadedRecipe.cuisine).toBe(loadedRecipe.cuisine);
    expect(reloadedRecipe.ingredients[1].original).toBe(loadedRecipe.ingredients[1].original);
    expect(reloadedRecipe.ingredients[1].isChecked).toBe(true);
    expect(savedMarkdown).toContain('Region:: Lazio');
    expect(savedMarkdown).toContain('author: Nonna Maria');
    expect(savedMarkdown).toMatch(/date:\s*['"]?2026-01-15['"]?/);
    expect(savedMarkdown).toContain('total_time: 15 mins');
  });
});

